import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Matches,
  Min,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;
const integer = ({ value }: { value: unknown }) =>
  typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
const boolean = ({ value }: { value: unknown }) => {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};
// PostgreSQL text cannot contain a NUL character.
// oxlint-disable-next-line no-control-regex
const databaseText = /^[^\u0000]*$/u;

export class ProductDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @Matches(databaseText)
  @MaxLength(160)
  name: string;

  @Transform(trim)
  @IsString()
  @Matches(databaseText)
  @MaxLength(4000)
  description = '';

  @Transform(trim)
  @IsString()
  @Matches(databaseText)
  @MaxLength(160)
  subtitle = '';

  @IsIn(['product', 'service'])
  type: 'product' | 'service';

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @Matches(databaseText)
  @MaxLength(80)
  category: string;

  @IsIn(['all', 'dogs', 'cats', 'other'])
  petType: 'all' | 'dogs' | 'cats' | 'other' = 'all';

  @Transform(integer)
  @IsInt()
  @Min(1)
  @Max(99_999_999)
  priceCents: number;

  @Transform(integer)
  @IsInt()
  @Min(0)
  @Max(99_999_999)
  costCents: number;

  @Transform(integer)
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  stock: number;
}

export class UpdateProductDto extends ProductDto {
  @Transform(boolean)
  @IsBoolean()
  removeImage = false;
}

export class ProductStatusDto {
  @IsBoolean()
  isActive: boolean;
}

export class ProductQueryDto {
  @Transform(trim)
  @IsString()
  @Matches(databaseText)
  @MaxLength(160)
  search = '';

  @ValidateIf((_, value: unknown) => value !== undefined)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @Matches(databaseText)
  @MaxLength(80)
  category?: string;

  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsIn(['product', 'service'])
  type?: 'product' | 'service';

  @IsIn(['all', 'in_stock', 'low_stock', 'out_of_stock'])
  stock: 'all' | 'in_stock' | 'low_stock' | 'out_of_stock' = 'all';

  @IsIn(['newest', 'price_asc', 'price_desc', 'stock'])
  sort: 'newest' | 'price_asc' | 'price_desc' | 'stock' = 'newest';

  @Transform(integer)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page = 1;

  @Transform(integer)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize = 5;
}
