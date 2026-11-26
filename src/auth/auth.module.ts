import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthRepository } from './auth.repository.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { AuthRateLimitGuard } from './guards/rate-limit.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { OtpMailerService } from './otp-mailer.service.js';

@Module({
  controllers: [AuthController],
  providers: [
    AuthRepository,
    OtpMailerService,
    AuthService,
    JwtAuthGuard,
    RolesGuard,
    AuthRateLimitGuard,
  ],
  exports: [AuthService, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
