import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import crypto from 'crypto';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import type { AccessTokenPayload } from './auth.types.js';
import {
  RequireActiveVendor,
  Roles,
} from './decorators/roles.decorator.js';
import {
  ForgotPasswordDto,
  LoginDto,
  ProvisionVendorDto,
  RegisterCustomerDto,
  ResendOtpDto,
  ResetPasswordDto,
  VerifyOtpDto,
} from './dto/auth.dto.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { AuthRateLimitGuard, RateLimit } from './guards/rate-limit.guard.js';
import { RolesGuard } from './guards/roles.guard.js';

const REFRESH_COOKIE_NAME = 'pm_refresh_token';
const OAUTH_STATE_COOKIE_NAME = 'pm_oauth_state';

interface AuthenticatedRequest extends Request {
  user?: AccessTokenPayload;
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  private getFrontendUrl(): string {
    return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  }

  private setRefreshCookie(res: Response, refreshToken: string): void {
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }

  @Post('register')
  @UseGuards(AuthRateLimitGuard)
  @RateLimit(20, 60)
  async registerCustomer(@Body() dto: RegisterCustomerDto) {
    return this.authService.registerCustomer(dto);
  }

  @Post('verify-otp')
  @UseGuards(AuthRateLimitGuard)
  @RateLimit(10, 60, true)
  @HttpCode(HttpStatus.OK)
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, accessToken, refreshToken } =
      await this.authService.verifyCustomerOtp(dto);
    this.setRefreshCookie(res, refreshToken);
    return { accessToken, user };
  }

  @Post('resend-otp')
  @UseGuards(AuthRateLimitGuard)
  @RateLimit(5, 60, true)
  @HttpCode(HttpStatus.OK)
  async resendOtp(@Body() dto: ResendOtpDto) {
    return this.authService.resendCustomerOtp(dto);
  }

  @Post('forgot-password')
  @UseGuards(AuthRateLimitGuard)
  @RateLimit(5, 60, true)
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.requestPasswordReset(dto);
  }

  @Post('reset-password')
  @UseGuards(AuthRateLimitGuard)
  @RateLimit(10, 60, true)
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPasswordWithOtp(dto);
  }

  @Post('login')
  @UseGuards(AuthRateLimitGuard)
  @RateLimit(10, 60, true)
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user, accessToken, refreshToken } = await this.authService.login(dto);
    this.setRefreshCookie(res, refreshToken);
    return { accessToken, user };
  }

  @Get('google')
  googleAuth(@Res() res: Response) {
    const frontendUrl = this.getFrontendUrl();

    if (!this.authService.isGoogleOAuthConfigured()) {
      return res.redirect(`${frontendUrl}/auth/login?error=google_not_configured`);
    }

    const state = crypto.randomBytes(24).toString('hex');
    res.cookie(OAUTH_STATE_COOKIE_NAME, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/v1/auth',
      maxAge: 10 * 60 * 1000,
    });

    return res.redirect(this.authService.getGoogleAuthUrl(state));
  }

  @Get('google/callback')
  async googleCallback(
    @Req() req: Request,
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') oauthError?: string,
  ) {
    const frontendUrl = this.getFrontendUrl();
    const expectedState = req.cookies?.[OAUTH_STATE_COOKIE_NAME] as string | undefined;

    res.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: '/api/v1/auth' });

    if (oauthError) {
      return res.redirect(`${frontendUrl}/auth/login?error=google_cancelled`);
    }

    if (!code || !state || !expectedState || state !== expectedState) {
      return res.redirect(`${frontendUrl}/auth/login?error=google_state_invalid`);
    }

    try {
      const { refreshToken } =
        await this.authService.authenticateWithGoogleCode(code);
      this.setRefreshCookie(res, refreshToken);
      return res.redirect(`${frontendUrl}/profile`);
    } catch (error: unknown) {
      if (error instanceof ForbiddenException) {
        return res.redirect(`${frontendUrl}/auth/login?error=vendor_google_blocked`);
      }
      return res.redirect(`${frontendUrl}/auth/login?error=google_failed`);
    }
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rawToken = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    const { user, accessToken, refreshToken } =
      await this.authService.refreshSession(rawToken);
    this.setRefreshCookie(res, refreshToken);
    return { accessToken, user };
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawToken = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    await this.authService.logout(rawToken);
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/api/v1/auth' });
    return { message: 'Signed out successfully' };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: AuthenticatedRequest) {
    return { user: await this.authService.getCurrentUser(req.user!.sub) };
  }

  @Post('admin/vendors')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  async provisionVendor(@Body() dto: ProvisionVendorDto) {
    const user = await this.authService.provisionVendorByAdmin(dto);
    return { user, message: 'Vendor account provisioned by Admin.' };
  }

  @Get('vendor/dashboard-summary')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @RequireActiveVendor()
  async vendorSummary(@Req() req: AuthenticatedRequest) {
    const user = await this.authService.getCurrentUser(req.user!.sub);
    return {
      message: 'Welcome to Vendor Portal',
      storeName: user.vendorProfile?.storeName,
      vendorStatus: user.vendorProfile?.vendorStatus,
    };
  }
}
