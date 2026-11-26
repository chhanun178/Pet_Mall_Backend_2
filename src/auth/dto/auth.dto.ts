import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { BusinessCategory, Role } from '../auth.types.js';

const trimString = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

const normalizeEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterCustomerDto {
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  fullName!: string;

  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @Transform(trimString)
  @IsString()
  @MinLength(7)
  @MaxLength(25)
  phone?: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(72, { message: 'Password must not exceed 72 characters' })
  @Matches(/[A-Z]/, { message: 'Password must include at least one uppercase letter' })
  @Matches(/[0-9]/, { message: 'Password must include at least one number' })
  password!: string;
}

export class ProvisionVendorDto {
  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  ownerName!: string;

  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @Transform(trimString)
  @IsString()
  @MinLength(7)
  @MaxLength(25)
  phone!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72, { message: 'Password must not exceed 72 characters' })
  @Matches(/[A-Z]/, { message: 'Password must include at least one uppercase letter' })
  @Matches(/[0-9]/, { message: 'Password must include at least one number' })
  password!: string;

  @Transform(trimString)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  storeName!: string;

  @IsEnum(['PET_FOOD', 'ACCESSORIES', 'GROOMING', 'VET_CLINIC'])
  businessCategory!: BusinessCategory;

  @Transform(trimString)
  @IsString()
  @MinLength(4)
  @MaxLength(60)
  taxOrLicenseId!: string;
}

export class LoginDto {
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(72)
  password!: string;

  @IsOptional()
  @IsEnum(['CUSTOMER', 'VENDOR', 'ADMIN'])
  expectedRole?: Role;
}

export class VerifyOtpDto {
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @Transform(trimString)
  @IsString()
  @Matches(/^\d{6}$/, { message: 'OTP must be a 6-digit code' })
  otp!: string;
}

export class ResendOtpDto {
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class ForgotPasswordDto {
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class ResetPasswordDto {
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @Transform(trimString)
  @IsString()
  @Matches(/^\d{6}$/, { message: 'OTP must be a 6-digit code' })
  otp!: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(72, { message: 'Password must not exceed 72 characters' })
  @Matches(/[A-Z]/, { message: 'Password must include at least one uppercase letter' })
  @Matches(/[0-9]/, { message: 'Password must include at least one number' })
  newPassword!: string;
}
