using System.Net.Http.Json;
using Application.Identity;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Infrastructure.Services;

public class EmailSettings
{
    public string ResendApiKey { get; set; } = "";
    public string FromEmail { get; set; } = "noreply@textstack.app";
    public string BaseUrl { get; set; } = "";
    /// <summary>Destination for operational alerts (failed jobs, etc.). If empty, alerts are skipped.</summary>
    public string AdminAlertEmail { get; set; } = "";
}

public class ResendEmailService : IEmailService
{
    private readonly HttpClient _http;
    private readonly EmailSettings _settings;
    private readonly ILogger<ResendEmailService> _logger;

    public ResendEmailService(HttpClient http, IOptions<EmailSettings> settings, ILogger<ResendEmailService> logger)
    {
        _http = http;
        _settings = settings.Value;
        _logger = logger;
    }

    public async Task SendAdminAlertAsync(string subject, string htmlBody, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(_settings.AdminAlertEmail) || string.IsNullOrWhiteSpace(_settings.ResendApiKey))
        {
            _logger.LogDebug("Admin alert skipped (no AdminAlertEmail or ResendApiKey): {Subject}", subject);
            return;
        }

        var payload = new
        {
            from = _settings.FromEmail,
            to = new[] { _settings.AdminAlertEmail },
            subject,
            html = htmlBody,
        };

        try
        {
            _http.DefaultRequestHeaders.Clear();
            _http.DefaultRequestHeaders.Add("Authorization", $"Bearer {_settings.ResendApiKey}");
            var response = await _http.PostAsJsonAsync("https://api.resend.com/emails", payload, ct);
            if (!response.IsSuccessStatusCode)
            {
                var body = await response.Content.ReadAsStringAsync(ct);
                _logger.LogError("Admin alert email failed: {Status} {Body}", response.StatusCode, body);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Admin alert email threw");
        }
    }

    public async Task SendPasswordResetEmailAsync(string toEmail, string resetToken, CancellationToken ct)
    {
        var resetUrl = $"{_settings.BaseUrl}/en/reset-password?token={Uri.EscapeDataString(resetToken)}";

        var html = $"""
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
              <h2 style="color: #111827; font-weight: 500; margin-bottom: 16px;">Reset your password</h2>
              <p style="color: #64748b; font-size: 15px; line-height: 1.6;">
                Click the button below to reset your TextStack password. This link expires in 1 hour.
              </p>
              <a href="{resetUrl}" style="display: inline-block; background: #C4704B; color: #fff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-size: 15px; margin: 20px 0;">
                Reset Password
              </a>
              <p style="color: #94a3b8; font-size: 13px; margin-top: 24px;">
                If you didn't request this, you can safely ignore this email.
              </p>
            </div>
            """;

        var payload = new
        {
            from = _settings.FromEmail,
            to = new[] { toEmail },
            subject = "Reset your TextStack password",
            html
        };

        _http.DefaultRequestHeaders.Clear();
        _http.DefaultRequestHeaders.Add("Authorization", $"Bearer {_settings.ResendApiKey}");

        var response = await _http.PostAsJsonAsync("https://api.resend.com/emails", payload, ct);

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(ct);
            _logger.LogError("Resend API error: {Status} {Body}", response.StatusCode, body);
        }
        else
        {
            _logger.LogInformation("Password reset email sent to {Email}", toEmail);
        }
    }
}
