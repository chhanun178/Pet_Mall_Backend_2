import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

@Injectable()
export class OtpMailerService {
  private readonly logger = new Logger(OtpMailerService.name);
  private readonly transporter: Transporter | null;
  private readonly fromAddress: string;

  constructor() {
    const host = process.env.SMTP_HOST?.trim();
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER?.trim();
    const pass = process.env.SMTP_PASS?.trim();
    this.fromAddress = process.env.SMTP_FROM?.trim() || 'Pet Mall <no-reply@petmall.com>';

    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
      this.logger.log(`SMTP OTP mailer configured (${host}:${port})`);
    } else {
      this.transporter = null;
      this.logger.log(
        'SMTP not configured; OTP codes will be logged to the backend console in dev.',
      );
    }
  }

  async sendVerificationOtp(email: string, otp: string): Promise<void> {
    await this.dispatchOtpEmail({
      email,
      otp,
      subject: `${otp} is your Pet Mall verification code`,
      badge: 'Customer Account Verification',
      heading: 'Confirm your email address',
      intro:
        'Happy pets, happy home. Use the 6-digit verification code below to activate your Pet Mall account:',
      note: "This code expires in 10 minutes. For your security, never share this code with anyone. If you didn't request this, you can safely ignore this email.",
      devTag: 'DEV OTP',
    });
  }

  async sendPasswordResetOtp(email: string, otp: string): Promise<void> {
    await this.dispatchOtpEmail({
      email,
      otp,
      subject: `${otp} is your Pet Mall password reset code`,
      badge: 'Password Reset Request',
      heading: 'Reset your password',
      intro:
        'We received a request to reset your Pet Mall password. Enter the 6-digit security code below to set a new password:',
      note: "This reset code expires in 10 minutes. If you didn't request a password reset, no changes were made and you can safely ignore this email.",
      devTag: 'DEV RESET OTP',
    });
  }

  private async dispatchOtpEmail(params: {
    email: string;
    otp: string;
    subject: string;
    badge: string;
    heading: string;
    intro: string;
    note: string;
    devTag: string;
  }): Promise<void> {
    if (!this.transporter) {
      if (process.env.NODE_ENV !== 'test') {
        this.logger.log(
          `[${params.devTag}] Code for ${params.email}: ${params.otp} (expires in 10m)`,
        );
      }
      return;
    }

    await this.transporter.sendMail({
      from: this.fromAddress,
      to: params.email,
      subject: params.subject,
      text: `${params.heading}\n\nYour Pet Mall code is: ${params.otp}\n\n${params.note}`,
      html: `
        <div style="margin: 0; padding: 32px 16px; background-color: #FCFAF6; font-family: 'Google Sans', Arial, sans-serif; color: #292524;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width: 480px; margin: 0 auto; background-color: #FFFFFF; border: 1px solid #EFEBE1; border-radius: 20px; overflow: hidden;">
            <tr>
              <td style="padding: 24px 28px 18px; border-bottom: 1px solid #EFEBE1;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="width: 36px; height: 36px; border-radius: 10px; background-color: #EA580C; text-align: center; vertical-align: middle; color: #FFFFFF; font-weight: 700; font-size: 16px;">
                      PM
                    </td>
                    <td style="padding-left: 10px; font-size: 19px; font-weight: 700; color: #1C1917; letter-spacing: -0.02em;">
                      Pet <span style="color: #EA580C;">Mall</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding: 28px;">
                <p style="margin: 0 0 6px; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #EA580C;">
                  ${params.badge}
                </p>
                <h1 style="margin: 0 0 10px; font-size: 22px; font-weight: 700; color: #1C1917;">
                  ${params.heading}
                </h1>
                <p style="margin: 0 0 22px; font-size: 14px; line-height: 1.55; color: #57534E;">
                  ${params.intro}
                </p>
                <div style="background-color: #FCFAF6; border: 1px solid #EFEBE1; border-radius: 14px; padding: 18px 16px; text-align: center;">
                  <span style="font-size: 32px; font-weight: 700; letter-spacing: 10px; color: #EA580C;">
                    ${params.otp}
                  </span>
                </div>
                <p style="margin: 20px 0 0; font-size: 12px; line-height: 1.5; color: #78716C;">
                  ${params.note}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding: 16px 28px; background-color: #FCFAF6; border-top: 1px solid #EFEBE1; font-size: 11px; color: #78716C; text-align: center;">
                Pet Mall • Curated nutrition, essentials &amp; local grooming care
              </td>
            </tr>
          </table>
        </div>
      `,
    });
  }
}
